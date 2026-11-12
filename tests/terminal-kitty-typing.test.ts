import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();

test('worker terminals type Space and Shift+letters once Droid enables Kitty keyboard flags', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const bundle = buildSync({
    stdin: {
      contents: "export { openTerminal, routeTerminalMessage } from './src/client/ui/terminal'; export { store } from './src/client/state'; export { Terminal } from '@xterm/xterm';",
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true,
    format: 'iife',
    globalName: 'TerminalUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<!doctype html><div id="mount" style="width:600px;height:350px"></div><div id="modal-root"></div>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const w = window as any;
    const { Terminal, store, openTerminal, routeTerminalMessage } = w.TerminalUI;
    const open = Terminal.prototype.open;
    Terminal.prototype.open = function (host: HTMLElement) {
      w.term = this;
      open.call(this, host);
    };
    const worker = { id: 'pixel', name: 'Pixel', kind: 'agent', color: '#89d9ed', status: 'idle', cols: 80, rows: 20, open: true };
    store.workers.set(worker.id, worker);
    w.messages = [];
    w.net = {
      up: true,
      send(msg: any) {
        w.messages.push(msg);
        // Droid's TUI pushes Kitty keyboard flag 1 (disambiguate) as soon as it starts.
        if (msg.t === 'worker.attach') queueMicrotask(() => routeTerminalMessage({ t: 'term.snapshot', workerId: worker.id, data: '\x1b[>1u', cols: worker.cols, rows: worker.rows, shared: true }));
        return true;
      },
      onStatus() {
        return () => {};
      },
    };
    w.input = () =>
      w.messages
        .filter((m: any) => m.t === 'term.input')
        .map((m: any) => m.data)
        .join('');
    w.handle = openTerminal(w.net, worker.id, undefined, undefined, { mount: document.getElementById('mount'), focus: true });
  });
  await page.waitForFunction(() => !!(window as any).term?.element && !(window as any).term.options.disableStdin);
  await page.evaluate(() => (window as any).term.focus());
  await page.waitForFunction(() => (window as any).term.textarea === document.activeElement);

  const typed = async (keys: string[]) => {
    await page.evaluate(() => {
      (window as any).messages.length = 0;
    });
    for (const k of keys) await page.keyboard.press(k);
    return page.evaluate(() => (window as any).input());
  };

  assert.equal(await typed(['h', 'i', 'Space', 'Shift+T', 'h', 'e', 'r', 'e']), 'hi There', 'plain Space and Shift+letters reach the PTY exactly once');
  assert.equal(await typed(['Shift+Space']), '\x1b[32;2u', 'modified Space stays a disambiguated CSI u key');
  assert.equal(await typed(['Enter']), '\r', 'Enter is sent once, not again on its keypress');
  assert.equal(await typed(['Shift+Enter']), '\x1b[13;2u');
  assert.equal(await typed(['Control+a']), '\x1b[97;5u');
  assert.deepEqual(errors, []);
});
