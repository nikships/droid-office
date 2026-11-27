import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { hostSnapshot } from './oracle/host-snapshot.js';

test('OSC 133 state and navigation follow real marks, never a reconstructed prompt', { skip: !browserStatus().installed }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'office-shell-features-'));
  const server = await createServer({
    root: fileURLToPath(new URL('../src/client', import.meta.url)),
    cacheDir,
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['@wterm/dom', '@wterm/ghostty'] },
  });
  t.after(async () => {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
  await server.listen();
  const addr = server.httpServer!.address();
  assert.ok(addr && typeof addr === 'object');
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(4000);
  await page.route('**/fixture', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/style.css"><div id="host" style="width:500px;height:128px"></div>' }));
  await page.addInitScript('window.__name = f => f');
  await page.goto(`http://127.0.0.1:${addr.port}/fixture`);
  await page.evaluate(async () => {
    const mod = '/term-engine/web-terminal.ts';
    const { createWebTerminal } = await import(mod);
    const w = window as any;
    const { term: a, features: keys } = createWebTerminal({ scrollback: 50, fontSize: 14, macOptionIsMeta: true });
    w.term = a;
    a.attachCustomKeyEventHandler((e: KeyboardEvent) => !keys.keyException(e, false));
    w.sent = [];
    a.onData((s: string) => w.sent.push(s));
    await a.open(document.querySelector('#host'));
    a.resize(24, 8);
    a.focus();
  });
  const write = (s: string) => page.evaluate((s) => (window as any).term.write(s), s);
  const chip = page.locator('.wterm-prompt-chip');
  const status = chip.getByRole('status');
  const mark = (s: string) => `\x1b]133;${s}\x07`;
  const first = `${mark('A')}first>${mark('B')} echo first\r\n${mark('C')}${'abcdef'.repeat(10)}\r\n${mark('D;7')}`;
  const second = `${'line\r\n'.repeat(9)}${mark('A')}second>${mark('B')} echo second\r\n${mark('C')}${mark('D;7')}${'line\r\n'.repeat(12)}`;
  assert.equal(await chip.isVisible(), false);
  await write('\x1b]133;');
  assert.equal(await chip.isVisible(), false);
  await write('A\x07');
  assert.equal(await status.textContent(), 'Prompt');
  await write(mark('C'));
  assert.equal(await status.textContent(), 'Running');
  await write(mark('D;0'));
  assert.equal(await status.textContent(), 'Exit 0');
  await write(first + second);
  assert.equal(await status.textContent(), 'Exit 7');

  await t.test('fullscreen applications own both bracket shortcuts until the normal screen returns', async () => {
    await write('\x1b[?104');
    assert.equal(await chip.isVisible(), true);
    await write('9h');
    assert.equal(await page.evaluate(() => (window as any).term.core.usingAltScreen()), true);
    assert.equal(await chip.isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Previous prompt' }).count(), 0);
    // Kitty disambiguation makes these physical shortcuts distinct application input.
    await write('\x1b[>1u');
    for (const code of ['BracketLeft', 'BracketRight']) {
      await page.keyboard.press(`Control+Shift+${code}`);
      assert.ok(await page.evaluate(() => (window as any).sent.splice(0).join('').length > 0), code);
    }
    await write('\x1b[<u\x1b[?1049l');
    assert.equal(await chip.isVisible(), true);
    assert.equal(await status.textContent(), 'Exit 7');
  });

  const viewport = () => page.evaluate(() => (window as any).term.buffer.active.viewportY);
  await page.waitForFunction(() => (window as any).term.buffer.active.viewportY > 15);
  await page.locator('#host .wterm').evaluate((el) => {
    el.scrollTop -= 5;
  });
  for (const code of ['BracketLeft', 'BracketLeft', 'BracketRight']) {
    const before = await viewport();
    await page.evaluate(() => {
      const w = window as any;
      w.stale = w.term.saveReader();
    });
    await page.keyboard.press(`Control+Shift+${code}`);
    await page.waitForFunction((prev) => (window as any).term.buffer.active.viewportY !== prev, before);
    const target = await viewport();
    assert.ok(code === 'BracketLeft' ? target < before : target > before);
    await page.evaluate(async () => {
      (window as any).stale?.();
      await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    });
    assert.equal(await viewport(), target);
  }
  const beforeResize = await viewport();
  // The shortcut's release belongs to the UI even if both modifiers were released first.
  await write('\x1b[>3u');
  await page.evaluate(() => {
    const a = (window as any).term;
    for (const down of [true, false]) {
      a.textarea.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code: 'BracketLeft', key: down ? '{' : '[', keyCode: 219, ctrlKey: down, shiftKey: down, bubbles: true, cancelable: true }));
    }
  });
  assert.deepEqual(await page.evaluate(() => (window as any).sent), []);
  await write('\x1b[<u');
  await page.evaluate(() => (window as any).term.resize(12, 8));
  await chip.getByRole('button', { name: 'Previous prompt' }).click();
  await chip.getByRole('button', { name: 'Previous prompt' }).focus();
  await chip.getByRole('button', { name: 'Next prompt' }).click();
  await page.waitForFunction((old) => (window as any).term.buffer.active.viewportY > old, beforeResize);
  // Reflow moved the marked row, not merely the scrollbar position.
  assert.equal(
    await page.evaluate(() => {
      const a = (window as any).term,
        row = a.buffer.active.viewportY,
        offset = a.core.getScrollbackCount() - 1 - row;
      return Array.from({ length: 7 }, (_, col) => {
        const cell = a.core.getScrollbackCell(offset, col);
        return cell.chars ?? String.fromCodePoint(cell.char || 32);
      }).join('');
    }),
    'second>',
  );
  await page.keyboard.type('k');
  assert.deepEqual(await page.evaluate(() => (window as any).sent.splice(0)), ['k'], 'typing after a prompt arrow goes to the PTY');
  await t.test('pointer prompt jumps keep terminal focus without a DECSET 1004 focus cycle', async () => {
    await write('\x1b[?1004h');
    const textarea = page.locator('#host textarea');
    await textarea.focus();
    const before = await viewport();
    await textarea.evaluate((el) => {
      const w = window as any;
      w.focusChanges = [];
      for (const type of ['blur', 'focus']) el.addEventListener(type, () => w.focusChanges.push(type), { once: true });
      w.sent.length = 0;
    });
    await chip.getByRole('button', { name: 'Previous prompt' }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).focusChanges), []);
    assert.ok(await textarea.evaluate((el) => el === document.activeElement));
    assert.ok((await viewport()) < before);
    assert.deepEqual(await page.evaluate(() => (window as any).sent), []);
  });
  await t.test('Enter on a prompt arrow jumps without passing repeats or release to the PTY', async () => {
    await write('\x1b[?1004l\x1b[>3u');
    await page.evaluate(() => (window as any).term.scrollToBottom());
    const prev = chip.getByRole('button', { name: 'Previous prompt' });
    await prev.focus();
    await page.evaluate(() => {
      (window as any).sent.length = 0;
    });
    const before = await viewport();
    await page.keyboard.down('Enter');
    const jumped = (await viewport()) < before;
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    assert.ok(jumped);
    assert.ok(await prev.evaluate((el) => el === document.activeElement));
    assert.deepEqual(await page.evaluate(() => (window as any).sent.splice(0)), []);
    await write('\x1b[<u');
  });
  await write('line\r\n'.repeat(65));
  assert.equal(
    await page.evaluate(() => {
      const a = (window as any).term;
      return a.core.findPrompt(a.core.getScrollbackCount() + a.rows - 1, -1);
    }),
    null,
  );
  await write('\x1bc');
  assert.equal(await chip.isVisible(), false);

  // Exercise the actual PTY host serialization path, not stripped output invented by this test.
  const replay = await hostSnapshot(first + second);
  assert.ok(replay.includes('first>'));
  assert.ok(!replay.includes('133;'));
  await page.evaluate(() => (window as any).term.reset());
  await write(replay);
  assert.equal(await chip.isVisible(), false);
  assert.equal(await page.evaluate(() => (window as any).term.native.scrollToPrompt(-1)), false);
  assert.deepEqual(await page.evaluate(() => (window as any).sent), []);

  await t.test('Option-drag copies a rectangle; Shift+Option overrides app mouse tracking', async () => {
    await page.evaluate(() => {
      const a = (window as any).term;
      a.reset();
      a.resize(24, 8);
      a.write(`${'history\r\n'.repeat(12)}012345\r\nabcdef\r\nUVWXYZ`);
    });
    await page.waitForFunction(() => document.querySelector('.term-grid')?.textContent?.includes('UVWXYZ'));
    const start = await page.evaluate(() => {
      const el = (window as any).term.native.element as HTMLElement;
      el.scrollTop -= 5;
      const top = [...el.querySelectorAll('.term-row')].find((row) => row.textContent?.includes('012345'))!.getBoundingClientRect();
      return { x: top.x, y: top.y, width: parseFloat(getComputedStyle(el).getPropertyValue('--term-cell-width')), height: top.height };
    });
    const drag = async (override: boolean) => {
      await page.keyboard.down('Alt');
      if (override) await page.keyboard.down('Shift');
      await page.mouse.move(start.x + start.width * 1.5, start.y + start.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(start.x + start.width * 3.5, start.y + start.height * 2.5, { steps: 5 });
      await page.mouse.up();
      if (override) await page.keyboard.up('Shift');
      await page.keyboard.up('Alt');
    };
    const selection = () => page.evaluate(() => (window as any).term.native.getSelectionText());
    for (const meta of [true, false]) {
      await page.evaluate((v) => {
        (window as any).term.options.macOptionIsMeta = v;
      }, meta);
      await drag(false);
      assert.equal(await selection(), '123\nbcd\nVWX');
      const copied = await page.evaluate(() => {
        const data = new DataTransfer();
        const a = (window as any).term;
        a.textarea.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }));
        a.native.clearSelection();
        return data.getData('text/plain');
      });
      assert.equal(copied, '123\nbcd\nVWX');
    }
    await write('\x1b[?1002;1006h');
    await drag(false);
    assert.ok(!(await selection()));
    assert.match(await page.evaluate(() => (window as any).sent.join('')), /\x1b\[</);
    await page.evaluate(() => {
      (window as any).sent = [];
    });
    await drag(true);
    assert.equal(await selection(), '123\nbcd\nVWX');
    assert.deepEqual(await page.evaluate(() => (window as any).sent), []);
  });
  await page.evaluate(() => (window as any).term.dispose());
  assert.equal(await chip.count(), 0);
});
