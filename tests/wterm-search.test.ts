import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { browserStatus, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { ORCHESTRATOR_ID } from '../src/shared/mission-control.js';

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
  // Find must also respect a real native thumb. Playwright hides it by default.
  const browser = await chromium.launch({ executablePath: browserStatus().executable, chromiumSandbox: true, ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--disable-features=OverlayScrollbar'] });
  t.after(() => browser.close());
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
  await t.test('Find keeps its count and accepts a step between a write and the refreshed scan', async () => {
    const rig = await page.evaluateHandle(async () => {
      const path = '/term-engine/web-terminal.ts';
      const { createWebTerminal } = await import(path);
      const host = document.createElement('div');
      host.className = 'host';
      document.body.append(host);
      const { term } = createWebTerminal({ fontSize: 14 });
      await term.open(host);
      term.resize(48, 5);
      term.write('one BIRD\r\ntwo BIRD\r\nthree BIRD\r\n');
      host.querySelector<HTMLButtonElement>('.wterm-search-panel button')!.click();
      const field = host.querySelector<HTMLInputElement>('.wterm-search-bar input')!;
      field.value = 'BIRD';
      field.dispatchEvent(new Event('input'));
      return { term, host };
    });
    try {
      await page.waitForFunction(({ term }) => term.native.getSearchState().count === 3 && !term.native.getSearchState().searching, rig);
      const during = await rig.evaluate(({ term, host }) => {
        term.write('four BIRD\r\n');
        const next = host.querySelector<HTMLButtonElement>('button[title="Next match (Enter)"]')!;
        const value = { label: host.querySelector('[role=status]')!.textContent, disabled: next.disabled };
        next.click();
        return value;
      });
      await page.waitForFunction(({ term }) => term.native.getSearchState().count === 4 && !term.native.getSearchState().searching, rig);
      const refreshed = await rig.evaluate(({ host }) => host.querySelector('[role=status]')!.textContent);
      assert.deepEqual({ ...during, refreshed }, { label: '1 of 3', disabled: false, refreshed: '2 of 4' });

      const transitions = await rig.evaluate(async ({ term, host }) => {
        const next = host.querySelector<HTMLButtonElement>('button[title="Next match (Enter)"]')!;
        const prev = host.querySelector<HTMLButtonElement>('button[title="Previous match (Shift+Enter)"]')!;
        const label = () => host.querySelector('[role=status]')!.textContent;
        const edit = (query: string) => {
          const field = host.querySelector('input')!;
          field.value = query;
          field.dispatchEvent(new Event('input'));
        };
        const settled = async () => {
          while (term.native.getSearchState().searching) await new Promise(requestAnimationFrame);
          return label();
        };
        const moves: number[] = [];
        for (const [method, dir] of [
          ['findNext', 1],
          ['findPrevious', -1],
        ] as const) {
          const apply = term.native[method].bind(term.native);
          term.native[method] = () => {
            moves.push(dir);
            return apply();
          };
        }
        term.write('more\r\n');
        prev.click();
        term.write('and more\r\n');
        next.click();
        next.click();
        const ordered = await settled();
        const compacted = moves.splice(0);
        term.write('again\r\n');
        for (let i = 0; i < 100; i++) next.click();
        const bounded = await settled();
        const burst = moves.splice(0);
        term.write('opposites\r\n');
        next.click();
        prev.click();
        await settled();
        const wholeLap = moves.splice(0);
        term.write('line\r\n');
        next.click();
        edit('NEW');
        const newQuery = [label(), next.disabled];
        const empty = await settled();
        term.write('NEW NEW\r\n');
        const lastEmpty = [label(), next.disabled];
        const found = await settled();
        term.write('line\r\n');
        prev.click();
        host.querySelector<HTMLButtonElement>('button[title="Close search (Esc)"]')!.click();
        host.querySelector<HTMLButtonElement>('.wterm-search-panel button')!.click();
        edit('NEW');
        return { ordered, compacted, bounded, burst, wholeLap, moves, newQuery, empty, lastEmpty, found, reopened: await settled() };
      });
      assert.deepEqual(transitions, {
        ordered: '2 of 4',
        compacted: [1],
        bounded: '1 of 4',
        burst: [1, -1],
        wholeLap: [1, -1],
        moves: [],
        newQuery: ['Searching…', true],
        empty: 'No matches',
        lastEmpty: ['No matches', true],
        found: '1 of 2',
        reopened: '1 of 2',
      });
    } finally {
      await rig.evaluate(({ term, host }) => {
        term.dispose();
        host.remove();
        (window as any).hostRig.term.focus();
      });
      await rig.dispose();
    }
  });
  for (const overlay of [false, true])
    await t.test(`${overlay ? 'overlay' : 'classic'} thumb and mouse-tracking history wheel supersede queued Find steps`, async (t) => {
      const pane = overlay
        ? await (async () => {
            // Enabling this feature without a mode follows the host's scrollbar preference.
            const b = await chromium.launch({ executablePath: browserStatus().executable, chromiumSandbox: true, ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--enable-features=OverlayScrollbar:mode/overlay'] });
            t.after(() => b.close());
            const p = await b.newPage();
            await p.route('**/overlay', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/style.css">' }));
            await p.addInitScript('window.__name = fn => fn');
            await p.goto(`http://127.0.0.1:${addr.port}/overlay`);
            return p;
          })()
        : page;
      const rig = await pane.evaluateHandle(async () => {
        const path = '/term-engine/web-terminal.ts';
        const { createWebTerminal } = await import(path);
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;inset:0;width:480px;height:320px;z-index:10000';
        document.body.append(host);
        const { term } = createWebTerminal({ scrollback: 1000 });
        await term.open(host);
        term.resize(48, 12);
        term.write(('BIRD\r\n' + 'line\r\n'.repeat(100)).repeat(3));
        host.querySelector<HTMLButtonElement>('.wterm-search-panel button')!.click();
        const field = host.querySelector<HTMLInputElement>('.wterm-search-bar input')!;
        field.value = 'BIRD';
        field.dispatchEvent(new Event('input'));
        return { term, host };
      });
      try {
        await pane.waitForFunction(({ term }) => !term.native.getSearchState().searching && term.native.getSearchState().count === 3, rig);
        // Reveal the native overlay thumb with reader input before trying to grab it.
        await pane.mouse.move(120, 100);
        await pane.mouse.wheel(0, 180);
        await pane.waitForFunction(({ term }) => term.native.element.scrollTop >= 100, rig);
        const { x, y, gutter, initialTop } = await rig.evaluate(({ term, host }) => {
          const el = term.native.element;
          const rect = el.getBoundingClientRect();
          term.write('\x1b[?2026h\r\n');
          host.querySelector<HTMLButtonElement>('button[title="Next match (Enter)"]')!.click();
          return { x: rect.right - 3, y: rect.top + ((el.scrollTop + el.clientHeight / 2) / el.scrollHeight) * el.clientHeight, gutter: el.offsetWidth - el.clientWidth, initialTop: el.scrollTop };
        });
        assert.ok(overlay ? gutter === 0 : gutter > 3, `Unexpected gutter: ${gutter}`);
        await pane.mouse.move(x, y);
        await pane.mouse.down();
        if (overlay) {
          await rig.evaluate(({ host }) => host.querySelector<HTMLInputElement>('.wterm-search-bar input')!.focus({ preventScroll: true }));
          await pane.keyboard.press('Enter'); // The held thumb can still supersede this newer step.
        }
        await pane.mouse.move(x, y + 75, { steps: 5 });
        await pane.mouse.up();
        const position = await rig.evaluate(async ({ term }) => {
          // The last compositor drag offset can reach the DOM after mouseup.
          await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
          const pos = { top: term.native.element.scrollTop, refreshing: term.native.getSearchState().searching };
          term.write('BIRD\r\n\x1b[?2026l');
          return pos;
        });
        assert.ok(position.top > initialTop && position.refreshing, JSON.stringify(position));
        await pane.waitForFunction(({ term }) => !term.native.getSearchState().searching && term.native.getSearchState().count === 4, rig);
        assert.deepEqual(await rig.evaluate(({ term }) => [term.native.getSearchState().activeIndex, term.native.element.scrollTop]), [0, position.top]);
        await rig.evaluate(({ term, host }) => {
          term.write('\x1b[?1000h\x1b[?2026h\r\n');
          host.querySelector<HTMLButtonElement>('button[title="Next match (Enter)"]')!.click();
        });
        await pane.mouse.move(120, 120);
        await pane.mouse.wheel(0, 180);
        await pane.waitForFunction(({ term, top }) => term.native.element.scrollTop > top, { term: await rig.getProperty('term'), top: position.top });
        const wheeled = await rig.evaluate(({ term }) => {
          const top = term.native.element.scrollTop;
          term.write('BIRD\r\n\x1b[?2026l');
          return top;
        });
        await pane.waitForFunction(({ term }) => !term.native.getSearchState().searching && term.native.getSearchState().count === 5, rig);
        assert.deepEqual(await rig.evaluate(({ term }) => [term.native.getSearchState().activeIndex, term.native.element.scrollTop]), [0, wheeled]);
        if (overlay) {
          await rig.evaluate(({ term }) => term.write('\x1b[?1000l' + ('BIRD '.repeat(8) + '\r\n').repeat(400)));
          await pane.waitForFunction(({ term }) => !term.native.getSearchState().searching && term.native.getSearchState().count > 3000, rig);
          // An output-following scroll while the mouse is held in padding is not a thumb drag.
          const origin = await rig.evaluate(async ({ term, host }) => {
            term.scrollToBottom();
            await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
            const el = term.native.element;
            el.style.paddingLeft = '8px';
            const rect = el.getBoundingClientRect();
            const x = rect.left + 4,
              y = rect.top + 100;
            const target = document.elementFromPoint(x, y) === el;
            term.write('\x1b[?2026h\r\n');
            host.querySelector<HTMLButtonElement>('button[title="Next match (Enter)"]')!.click();
            return { x, y, target, top: el.scrollTop };
          });
          assert.ok(origin.target, 'left padding must target the scrollport itself');
          await pane.mouse.move(origin.x, origin.y);
          await pane.mouse.down();
          const followed = await rig.evaluate(async ({ term }) => {
            const painted = new Promise<number>((done) => {
              term.write('output\r\n'.repeat(32) + '\x1b[?2026l');
              requestAnimationFrame(() => {
                // More synchronized output arrives after the tail paints, before the search can finish.
                term.write('\x1b[?2026h\r');
                requestAnimationFrame(() => done(term.native.element.scrollTop));
              });
            });
            const top = await painted;
            term.write('\x1b[?2026l');
            return top;
          });
          await pane.mouse.move(600, 400);
          await pane.mouse.up();
          assert.ok(followed > origin.top, `tail did not follow: ${origin.top}→${followed}`);
          await pane.waitForFunction(({ term }) => !term.native.getSearchState().searching, rig);
          assert.equal(await rig.evaluate(({ term }) => term.native.getSearchState().activeIndex), 1);
        }
      } finally {
        await rig.evaluate(({ term, host }) => {
          term.dispose();
          host.remove();
          (window as any).hostRig?.term.focus();
        });
        await rig.dispose();
      }
    });
  await t.test('only terminal rows and padding define the scroll range through clears, replay, reflow, Find and IME', async () => {
    const samples = await page.evaluate(async () => {
      const path = '/term-engine/web-terminal.ts';
      const { createWebTerminal } = await import(path);
      const pane = document.createElement('div');
      const focused = document.activeElement as HTMLElement;
      pane.className = 'modal term inline';
      pane.style.cssText = 'position:fixed;inset:0;width:600px;height:200px;z-index:10';
      const host = document.createElement('div');
      host.className = 'term-host';
      pane.append(host);
      document.body.append(pane);
      const { term } = createWebTerminal({ fontSize: 14, scrollback: 500 });
      try {
        await term.open(host);
        const el = term.native.element,
          input = term.textarea;
        const results = [];
        const read = async (step: string) => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const last = el.querySelectorAll('.term-row:not(.term-scrollback-row)')[term.rows - 1];
          const end = last.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop + parseFloat(getComputedStyle(el).paddingBottom);
          results.push({ step, actual: el.scrollHeight, expected: Math.max(el.clientHeight, Math.round(end)) });
        };
        term.resize(35, 10);
        const history = Array.from({ length: 90 }, (_, i) => `keep ${i} ${'x'.repeat(50)}\r\n`).join('');
        term.write(history);
        await read('history');
        term.focus();
        term.write('\x1b[3J\x1b[H\x1b[2J');
        await read('focused clear');
        term.write(history);
        await read('refill');
        term.focus();
        term.reset();
        term.write('replayed');
        await read('short attach snapshot');
        term.write(history);
        await read('long attach snapshot');
        term.focus();
        for (const cols of [60, 20]) {
          term.resize(cols, 10);
          await read(`resize to ${cols} columns`);
        }
        el.querySelector('.wterm-search-panel > button').click();
        const find = el.parentElement.querySelector('input[aria-label="Find in terminal"]');
        if (!find) throw Error('missing Find');
        find.value = 'keep 77';
        find.dispatchEvent(new Event('input', { bubbles: true }));
        await read('Find reveal');
        if (document.activeElement !== find || !term.native.getSearchState().count) throw Error('Find did not reveal the retained match');
        find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        term.scrollToBottom();
        term.focus();
        term.write('\x1b[10;4H');
        await read('last-row cursor');
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        await read('visible IME preedit');
        const caret = input.getBoundingClientRect(),
          lastRow = Array.from(el.querySelectorAll('.term-row')).at(-1) as HTMLElement;
        if (Math.abs(caret.top - lastRow.getBoundingClientRect().top) > 1 || caret.height > lastRow.offsetHeight + 1) throw Error('IME preedit is not at the last-row cursor');
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        term.write('\x1b[3J\x1b[H\x1b[2J');
        await read('clear after IME');
        return results;
      } finally {
        term.dispose();
        pane.remove();
        focused.focus({ preventScroll: true });
      }
    });
    for (const s of samples) assert.ok(Math.abs(s.expected - s.actual) <= 1, JSON.stringify(s));
  });
  await t.test('fresh f and g reach the Find field after a shortcut without its letter keyup', async () => {
    const cdp = await context.newCDPSession(page);
    const values = [];
    try {
      for (const key of ['f', 'g']) {
        // macOS may omit the letter keyup while Cmd is held. The next press is not a repeat.
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: `Key${key.toUpperCase()}`, modifiers: key === 'f' && !mac ? 10 : 4 });
        await page.keyboard.press(key);
        values.push(await find.inputValue());
        await find.fill('');
      }
    } finally {
      await cdp.detach();
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(values, ['f', 'g']);
  });
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
  await t.test('holding Find Escape through focus changes sends no key to the PTY', async () => {
    await page.keyboard.press(shortcut);
    await page.evaluate(() => {
      (window as any).keys.length = 0;
    });
    await page.keyboard.down('Escape');
    assert.equal(await find.isVisible(), false);
    await page.keyboard.down('Escape');
    await page.locator('#log textarea').focus();
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    assert.deepEqual(await page.evaluate(() => (window as any).keys), []);
    assert.deepEqual(await page.evaluate(() => (window as any).sent.splice(0)), []);
    await page.locator('#host textarea').focus();
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => (window as any).sent.splice(0)), ['\x1b']);
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
  await t.test('readTerminal skips offscreen and explicitly paused panes without waiting for a paint', async () => {
    const log = page.locator('#log .wterm');
    await log.evaluate((el) => {
      el.parentElement!.style.transform = 'translateY(200vh)';
    });
    await frame();
    assert.equal(await log.evaluate((el) => el.checkVisibility() && el.getBoundingClientRect().top > innerHeight), true);
    const readWorkers = async () => {
      await page.evaluate(() => {
        const w = window as any;
        w.readIds = null;
        void w.office.readTerminal().then((rows: { workerId?: string }[]) => {
          w.readIds = rows.map((r) => r.workerId);
        });
      });
      await page.waitForFunction(() => (window as any).readIds !== null, undefined, { timeout: 2000 });
      return page.evaluate(() => (window as any).readIds);
    };
    try {
      assert.deepEqual(await readWorkers(), ['w']);
      await log.evaluate((el) => {
        el.parentElement!.style.transform = '';
      });
      await frame();
      await page.evaluate(async () => {
        const w = window as any;
        w.interruptedRead = null;
        void w.office.readTerminal().then((rows: { workerId?: string }[]) => {
          w.interruptedRead = rows.map((r) => r.workerId);
        });
        await Promise.resolve(); // Pause after capture was requested but before the native paint.
        w.logRig.term.setRenderingPaused(true);
      });
      await page.waitForFunction(() => (window as any).interruptedRead !== null, undefined, { timeout: 2000 });
      assert.deepEqual(await page.evaluate(() => (window as any).interruptedRead), ['w']);
      assert.deepEqual(await readWorkers(), ['w']);
    } finally {
      await log.evaluate((el) => {
        el.parentElement!.style.transform = '';
      });
      await page.evaluate(() => (window as any).logRig.term.setRenderingPaused(false));
      await frame();
    }
  });
  await t.test('concurrent page-local reads each finish with both terminal snapshots', async () => {
    const results = await page.evaluate(() => {
      const w = window as any;
      return Promise.all([w.office.readTerminal(), w.office.readTerminal()]);
    });
    assert.equal(results[0].length, 2);
    assert.match(results[0][0].text, /beginning/);
    assert.deepEqual(results[1], results[0]);
  });
  await t.test('a covered dashboard pane is mounted but not readable', async () => {
    const host = page.locator('#log');
    try {
      await host.evaluate((el) => {
        el.classList.add('dash-pane', 'covered');
        el.setAttribute('inert', '');
      });
      assert.equal(await host.evaluate((el) => getComputedStyle(el).opacity), '0');
      const rows = await page.evaluate(() => (window as any).office.readTerminal());
      assert.deepEqual(
        rows.map((r: { workerId?: string }) => r.workerId),
        ['w'],
      );
    } finally {
      await host.evaluate((el) => {
        el.classList.remove('dash-pane', 'covered');
        el.removeAttribute('inert');
      });
    }
  });
  await t.test('disposing one pane during capture leaves the other panes readable', async () => {
    const results = await page.evaluate(async () => {
      const mod = '/term-engine/web-terminal.ts';
      const { createWebTerminal } = await import(mod);
      const host = document.createElement('div');
      host.className = 'host';
      document.body.prepend(host);
      const { term } = createWebTerminal({});
      try {
        await term.open(host);
        await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
        const reading = (window as any).office.readTerminal();
        await Promise.resolve();
        term.dispose();
        return await reading;
      } finally {
        term.dispose();
        host.remove();
      }
    });
    assert.equal(results.length, 2);
    assert.match(results[0].text, /beginning/);
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
  await t.test('a new query can step partial native results; unchanged refreshes do not republish the count', async () => {
    const result = await page.evaluate(async () => {
      const load = (path: string) => import(path);
      const [{ WTermAdapter }, { createWtermSearch, useNativeSearchControls }] = await Promise.all([load('/term-engine/wterm.ts'), load('/term-engine/wterm-search-controls.ts')]);
      const term = new WTermAdapter({ scrollback: 2400 });
      useNativeSearchControls(term);
      const host = document.createElement('div');
      document.body.append(host);
      const events: { count: number; searching: boolean; activeIndex: number; query: string }[] = [];
      try {
        await term.open(host);
        term.resize(60, 12);
        term.write('match match history\r\n'.repeat(2000));
        let search: ReturnType<typeof createWtermSearch>;
        term.onOpen((native: unknown, signal: AbortSignal) => {
          search = createWtermSearch(term, native, signal, { onChange: (s: (typeof events)[number]) => events.push(s) });
        });
        const native = term.native;
        const report = native.onSearchChange;
        const partial: number[] = [];
        native.onSearchChange = (s: (typeof events)[number]) => {
          report(s);
          if (!partial.length && s.searching && s.count >= 2) {
            partial.push(s.count, search.getState().count, events.at(-1)!.count);
            partial.push(Number(search.next()), native.getSearchState().activeIndex);
            Reflect.deleteProperty(performance, 'now');
          }
        };
        // Force a slice boundary independent of machine speed; all matches and
        // notifications still come from scanning the real Ghostty history.
        let clock = performance.now();
        Object.defineProperty(performance, 'now', { configurable: true, value: () => (clock += 5) });
        search!.open();
        search!.setQuery('match');
        const settled = async () => {
          while (native.getSearchState().searching) await new Promise(requestAnimationFrame);
        };
        await settled();
        events.length = 0;
        term.write('\r');
        await settled(); // WTerm resets the index once, but not the completed count.
        const afterIndexReset = events.splice(0).map((s) => [s.activeIndex, s.count]);
        term.write('\r');
        term.write('\r');
        await settled();
        const duplicates = events.length;
        term.write('\r');
        for (let i = 0; i < 1200; i++) search!.next();
        await settled();
        const capped = events.splice(0).map((s) => s.activeIndex);
        const bursts = [];
        for (const [matches, clicks] of [
          [19, 10],
          [21, 9],
          [5, 7],
        ]) {
          const query = `burst${matches}`;
          term.write(`\r\n${(query + ' ').repeat(matches)}`);
          search!.setQuery(query);
          await settled();
          term.write('\r');
          const accepted = Array.from({ length: clicks }, () => search!.next());
          await settled();
          bursts.push([accepted.filter(Boolean).length, search!.getState().activeIndex]);
        }
        events.length = 0;
        search!.setQuery('absent');
        const edited = [events[0]?.query, events[0]?.searching];
        return { partial, afterIndexReset, duplicates, capped, bursts, edited };
      } finally {
        Reflect.deleteProperty(performance, 'now');
        term.dispose();
        host.remove();
      }
    });
    const [raw, displayed, emitted, stepped, index] = result.partial;
    assert.ok(raw >= 2);
    assert.deepEqual([displayed, emitted, stepped, index], [raw, raw, 1, 1]);
    assert.deepEqual(result.afterIndexReset, [[0, 4000]]);
    assert.equal(result.duplicates, 0);
    assert.deepEqual(result.capped, [8]); // One bridge emission, no intermediate indices.
    assert.deepEqual(result.bursts, [
      [8, 8],
      [8, 8],
      [7, 2],
    ]);
    assert.deepEqual(result.edited, ['absent', true]);
  });
  await t.test('externalLauncher omits the floating Find button and syncs toggleSearch/onOpenChange including before open', async () => {
    const measured = await page.evaluate(async () => {
      const load = (p: string) => import(p);
      const { createWebTerminal } = await load('/term-engine/web-terminal.ts');
      const host = document.createElement('div');
      host.className = 'host';
      document.body.append(host);
      const events: boolean[] = [];
      const { term, features } = createWebTerminal({ scrollback: 200, fontSize: 14, fontFamily: 'monospace' }, undefined, undefined, {
        externalLauncher: true,
        onOpenChange: (open: boolean) => events.push(open),
      });
      // Request Find before open() finishes to verify deferred open works without races.
      features.toggleSearch();
      try {
        await term.open(host);
        term.resize(20, 5);
        term.write('alpha beta alpha');
        await new Promise((r) => requestAnimationFrame(r));
        const launcherCount = host.querySelectorAll('.wterm-search-panel > button').length;
        const field = host.querySelector<HTMLInputElement>('input[aria-label="Find in terminal"]');
        const bar = host.querySelector<HTMLElement>('.wterm-search-bar')!;
        const openedBeforeClick = !!field && !bar.hidden && document.activeElement === field;
        features.toggleSearch();
        const closedAfterToggle = bar.hidden && document.activeElement === term.textarea;
        features.toggleSearch();
        const reopened = !bar.hidden && document.activeElement === field;
        term.reset();
        const closedOnReset = bar.hidden;
        return { launcherCount, openedBeforeClick, closedAfterToggle, reopened, closedOnReset, events };
      } finally {
        term.dispose();
        host.remove();
      }
    });
    assert.deepEqual(measured, {
      launcherCount: 0,
      openedBeforeClick: true,
      closedAfterToggle: true,
      reopened: true,
      closedOnReset: true,
      events: [true, false, true, false],
    });
  });
  await t.test('companion pane places a magnifying glass next to other tools instead of the floating Find button', async () => {
    await page.evaluate(async (orchestratorId) => {
      const load = (p: string) => import(p);
      const [{ createPane }, { store }, terminal] = await Promise.all([load('/dashboard-pane.ts'), load('/state.ts'), load('/ui/terminal.ts')]);
      const wrap = document.createElement('div');
      wrap.id = 'companion-find-wrap';
      wrap.style.cssText = 'position:fixed;inset:0;width:800px;height:400px;display:flex;z-index:200';
      document.body.append(wrap);
      const worker = { id: 'w-pane', name: 'Nibble', color: '#89d9ed', kind: 'agent', status: 'ready', acked: true, cols: 40, rows: 10 };
      const orch = { id: orchestratorId, name: 'Orchestrator', color: '#ef6f2e', kind: 'agent', status: 'ready', acked: true, cols: 40, rows: 10, sessionId: 'orc-1' };
      store.workers.set(worker.id, worker);
      const mission = { orchestrator: { settings: { on: true }, agent: { worker: orch, team: [] } }, bots: [] };
      store.missionControl = mission;
      const noop = () => {};
      const net = { up: true, send: () => true, onStatus: () => noop, onMessage: () => noop };
      const host = {
        net,
        live: () => true,
        floor: () => 'floor',
        busy: () => false,
        action: async () => undefined,
        usable: () => true,
        read: () => '',
        remember: noop,
        terminal: async () => terminal,
        setView: noop,
        focus: noop,
        close: noop,
        toggleMax: noop,
        assign: noop,
        swap: noop,
        openBeside: noop,
        sendHome: noop,
        hire: noop,
        worker: (id: string) => (id === orchestratorId ? orch : store.workers.get(id)),
        mission: () => mission,
        openAcross: noop,
        resetOrchestrator: noop,
        settings: noop,
      };
      const pane = createPane(host, 0);
      pane.el.style.cssText = 'position:relative;width:100%;height:100%;animation:none;transition:none';
      wrap.append(pane.el);
      (window as any).companionRig = { pane, worker, orch, wrap };
      pane.update({ worker: orch, view: 'terminal', focused: true, maximized: false, canMaximize: false, covered: false, candidates: [], anyone: true, takeFocus: false });
    }, ORCHESTRATOR_ID);
    const wrap = page.locator('#companion-find-wrap');
    try {
      await wrap.locator('.office-wterm').waitFor();
      await frame();
      // Orchestrator TTY pane: magnifying glass sits right next to refresh + settings, no floating Find button.
      assert.equal(await wrap.locator('.wterm-search-panel > button').count(), 0);
      const orchActions = await wrap.locator('.dash-pane-actions > *').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
      assert.match(orchActions[0], /^Find in terminal \(/);
      assert.deepEqual(orchActions.slice(1), ['New conversation', 'Orchestrator settings']);
      const findBtn = wrap.locator('.dash-pane-actions button.dash-pane-find');
      assert.equal(await findBtn.locator('svg').count(), 1);
      assert.equal(await findBtn.getAttribute('aria-pressed'), 'false');

      // Clicking the magnifying glass opens the search bar and highlights the button; clicking again closes and returns focus.
      await findBtn.click();
      const input = wrap.locator('input[aria-label="Find in terminal"]');
      await input.waitFor({ state: 'visible' });
      assert.equal(await findBtn.getAttribute('aria-pressed'), 'true');
      assert.equal(await findBtn.evaluate((el) => el.classList.contains('on')), true);
      assert.equal(await input.evaluate((el) => el === document.activeElement), true);
      await findBtn.click();
      assert.equal(await input.isVisible(), false);
      assert.equal(await findBtn.getAttribute('aria-pressed'), 'false');
      assert.equal(await wrap.locator('.office-wterm textarea').evaluate((el) => el === document.activeElement), true);

      // Keyboard shortcut and Esc stay synced with the header button.
      await page.keyboard.press(shortcut);
      assert.equal(await input.isVisible(), true);
      assert.equal(await findBtn.getAttribute('aria-pressed'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await input.isVisible(), false);
      assert.equal(await findBtn.getAttribute('aria-pressed'), 'false');

      // Regular worker TTY pane keeps the magnifying glass next to Send home; switching to Thread removes it.
      const showView = (view: 'terminal' | 'thread') =>
        page.evaluate((v) => {
          const { pane, worker } = (window as any).companionRig;
          pane.update({ worker, view: v, focused: true, maximized: false, canMaximize: false, covered: false, candidates: [], anyone: true, takeFocus: false });
        }, view);
      await showView('terminal');
      await wrap.locator('.office-wterm').waitFor();
      assert.equal(await wrap.locator('.wterm-search-panel > button').count(), 0);
      const workerActions = await wrap.locator('.dash-pane-actions > *').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
      assert.match(workerActions[0], /^Find in terminal \(/);
      assert.ok(workerActions.includes('Send home'), workerActions.join());

      await showView('thread');
      assert.equal(await wrap.locator('button.dash-pane-find').count(), 0);
    } finally {
      await page.evaluate(() => {
        const rig = (window as any).companionRig;
        rig?.pane.dispose();
        rig?.wrap.remove();
        delete (window as any).companionRig;
      });
    }
  });
});
